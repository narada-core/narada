use narada_invokable_intelligence_runtime::{preflight, PreflightRequest, ResolverDigests};
use rusqlite::{params, Connection};
use serde_json::json;
use sha2::Digest;
use std::fs;

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn request() -> PreflightRequest {
    PreflightRequest {
        schema: "narada.invokable-intelligence.preflight-request.v1".to_string(),
        intent_id: "intent:test".to_string(),
        purpose: None,
        principal: None,
        requested_plan_id: None,
        evaluated_at: "2026-08-12T12:00:00Z".to_string(),
        clock_authority_ref: "clock:test".to_string(),
        mode: "immediate".to_string(),
        current_digests: Some(ResolverDigests {
            normalized_resolver_input: digest('a'),
            catalog: digest('b'),
            policy: digest('c'),
            assertions: digest('d'),
            topology: digest('e'),
            access: digest('f'),
            materialization: digest('0'),
        }),
    }
}

fn registry(valid_until: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "narada-preflight-{}-{}-{}.db",
        std::process::id(),
        unique,
        valid_until.replace(':', "")
    ));
    let _ = fs::remove_file(&path);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE invocation_intents (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL); CREATE TABLE invocation_plans (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, resolver_version TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL); CREATE TABLE catalog_records (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, revision INTEGER NOT NULL, doc TEXT NOT NULL);").unwrap();
    let request = request();
    let plan = json!({
        "schema": "narada.invokable-intelligence.invocation-plan.v2",
        "id": "plan:test",
        "intent_id": request.intent_id,
        "created_at": "2026-08-12T11:00:00Z",
        "resolver_version": "test",
        "selected": {"model":{"id":"model:test"},"adapter":{"id":"adapter:test"}},
        "snapshot": {
            "schema": "narada.invokable-intelligence.plan-decision-snapshot.v1",
            "plan_id": "plan:test",
            "intent_id": "intent:test",
            "resolver_version": "test",
            "resolved_at": "2026-08-12T11:00:00Z",
            "valid_until": valid_until,
            "clock": {"authority_ref":"clock:test"},
            "digests": request.current_digests,
            "snapshot_digest": digest('9'),
            "revalidation_triggers": ["before-retry"],
            "referenced_revisions": [{"kind":"materialization","record_id":"projection:test","revision":"1","digest":digest('8'),"immutable_ref":"projection:test"}],
            "lineage": {"relation":"initial"}
        }
    });
    connection
        .execute(
            "INSERT INTO invocation_intents VALUES (?1, ?2, ?3, ?4)",
            params![
                "intent:test",
                "worker-step",
                "2026-08-12T11:00:00Z",
                json!({"id":"intent:test","purpose":"worker-step","principal":"principal:test"})
                    .to_string()
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO invocation_plans VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                "plan:test",
                "intent:test",
                "test",
                "2026-08-12T11:00:00Z",
                plan.to_string()
            ],
        )
        .unwrap();
    path
}

#[test]
fn admits_only_current_matching_plan() {
    let path = registry("2026-08-12T13:00:00Z");
    assert!(preflight(&path, &request()).admitted());
    fs::remove_file(path).unwrap();
}

#[test]
fn refuses_expired_and_changed_plans() {
    let path = registry("2026-08-12T12:00:00Z");
    assert!(!preflight(&path, &request()).admitted());
    fs::remove_file(path).unwrap();

    let path = registry("2026-08-12T13:00:00Z");
    let mut changed = request();
    changed.current_digests.as_mut().unwrap().catalog = digest('7');
    assert!(!preflight(&path, &changed).admitted());
    fs::remove_file(path).unwrap();
}

#[test]
fn resolves_unique_semantic_intent_without_plan_reference() {
    let path = registry("2026-08-12T13:00:00Z");
    let mut semantic = request();
    semantic.intent_id.clear();
    semantic.purpose = Some("worker-step".to_string());
    semantic.principal = Some("principal:test".to_string());
    semantic.current_digests = None;
    assert!(preflight(&path, &semantic).admitted());
    fs::remove_file(path).unwrap();
}

#[test]
fn validates_digest_at_catalog_document_boundary() {
    let path = registry("2026-08-12T13:00:00Z");
    let connection = Connection::open(&path).unwrap();
    let document = json!({"schema":"narada.invokable-intelligence.model.v1","id":"model:test"});
    let canonical = r#"{"id":"model:test","schema":"narada.invokable-intelligence.model.v1"}"#;
    let actual_digest = format!("sha256:{:x}", sha2::Sha256::digest(canonical.as_bytes()));
    connection
        .execute(
            "INSERT INTO catalog_records VALUES (?1, ?2, ?3, ?4)",
            params![
                "catalog:test",
                "model:test",
                1,
                json!({"id":"catalog:test","record_id":"model:test","document":document})
                    .to_string()
            ],
        )
        .unwrap();
    let plan_text: String = connection
        .query_row(
            "SELECT doc FROM invocation_plans WHERE id='plan:test'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut plan: serde_json::Value = serde_json::from_str(&plan_text).unwrap();
    plan["snapshot"]["referenced_revisions"] = json!([{"kind":"catalog","record_id":"model:test","revision":"1","digest":actual_digest,"immutable_ref":"catalog:test"}]);
    connection
        .execute(
            "UPDATE invocation_plans SET doc=?1 WHERE id='plan:test'",
            [plan.to_string()],
        )
        .unwrap();
    drop(connection);
    assert!(preflight(&path, &request()).admitted());
    fs::remove_file(path).unwrap();
}
