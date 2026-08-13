use narada_invokable_intelligence_runtime::{preflight, PreflightRequest, ResolverDigests};
use rusqlite::{params, Connection};
use serde_json::json;
use std::fs;

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn request() -> PreflightRequest {
    PreflightRequest {
        schema: "narada.invokable-intelligence.preflight-request.v1".to_string(),
        intent_id: "intent:test".to_string(),
        requested_plan_id: None,
        evaluated_at: "2026-08-12T12:00:00Z".to_string(),
        clock_authority_ref: "clock:test".to_string(),
        mode: "immediate".to_string(),
        current_digests: ResolverDigests {
            normalized_resolver_input: digest('a'),
            catalog: digest('b'),
            policy: digest('c'),
            assertions: digest('d'),
            topology: digest('e'),
            access: digest('f'),
            materialization: digest('0'),
        },
    }
}

fn registry(valid_until: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "narada-preflight-{}-{}.db",
        std::process::id(),
        valid_until.replace(':', "")
    ));
    let _ = fs::remove_file(&path);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE invocation_plans (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, resolver_version TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);").unwrap();
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
            "referenced_revisions": [{"kind":"catalog","record_id":"model:test","revision":"1","digest":digest('8'),"immutable_ref":"catalog:test"}],
            "lineage": {"relation":"initial"}
        }
    });
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
    changed.current_digests.catalog = digest('7');
    assert!(!preflight(&path, &changed).admitted());
    fs::remove_file(path).unwrap();
}
