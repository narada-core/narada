use chrono::{DateTime, FixedOffset};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

const PLAN_SCHEMA: &str = "narada.invokable-intelligence.invocation-plan.v2";
const SNAPSHOT_SCHEMA: &str = "narada.invokable-intelligence.plan-decision-snapshot.v1";
const PREFLIGHT_SCHEMA: &str = "narada.invokable-intelligence.preflight-request.v1";

#[derive(Debug, Clone, Deserialize)]
pub struct PreflightRequest {
    pub schema: String,
    #[serde(default)]
    pub intent_id: String,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub principal: Option<String>,
    #[serde(default)]
    pub requested_plan_id: Option<String>,
    pub evaluated_at: String,
    pub clock_authority_ref: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub current_digests: Option<ResolverDigests>,
}

fn default_mode() -> String {
    "immediate".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ResolverDigests {
    pub normalized_resolver_input: String,
    pub catalog: String,
    pub policy: String,
    pub assertions: String,
    pub topology: String,
    pub access: String,
    pub materialization: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PreflightOutcome {
    Admitted {
        schema: &'static str,
        intent_id: String,
        plan_ref: String,
        snapshot_digest: String,
        selected: Value,
        evidence_ref: String,
        checked_at: String,
    },
    Refused {
        schema: &'static str,
        intent_id: String,
        code: String,
        reasons: Vec<String>,
        checked_at: String,
    },
}

impl PreflightOutcome {
    pub fn admitted(&self) -> bool {
        matches!(self, Self::Admitted { .. })
    }
}

pub fn preflight(registry_path: &Path, request: &PreflightRequest) -> PreflightOutcome {
    let refuse = |code: &str, reasons: Vec<String>| PreflightOutcome::Refused {
        schema: "narada.invokable-intelligence.preflight-refusal.v1",
        intent_id: request.intent_id.clone(),
        code: code.to_string(),
        reasons,
        checked_at: request.evaluated_at.clone(),
    };
    if request.schema != PREFLIGHT_SCHEMA
        || (request.intent_id.trim().is_empty()
            && request.purpose.as_deref().is_none_or(str::is_empty))
        || request.clock_authority_ref.trim().is_empty()
        || !valid_mode(&request.mode)
        || parse_instant(&request.evaluated_at).is_none()
        || request
            .current_digests
            .as_ref()
            .is_some_and(|value| !digests_valid(value))
    {
        return refuse(
            "preflight_request_invalid",
            vec!["invalid-explicit-input".to_string()],
        );
    }
    let connection = match Connection::open_with_flags(
        registry_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(connection) => connection,
        Err(error) => return refuse("registry_unavailable", vec![error.to_string()]),
    };
    if request.intent_id.trim().is_empty() {
        let intent_id = match resolve_semantic_intent(&connection, request) {
            Ok(intent_id) => intent_id,
            Err((code, reasons)) => return refuse(code, reasons),
        };
        let mut resolved = request.clone();
        resolved.intent_id = intent_id;
        return preflight(registry_path, &resolved);
    }
    let plan_doc = match load_plan(&connection, request) {
        Ok(Some(doc)) => doc,
        Ok(None) => {
            return refuse(
                "plan_not_found",
                vec!["no-recorded-plan-for-intent".to_string()],
            )
        }
        Err(error) => return refuse("registry_read_failed", vec![error]),
    };
    let plan: Value = match serde_json::from_str(&plan_doc) {
        Ok(plan) => plan,
        Err(error) => return refuse("plan_invalid", vec![error.to_string()]),
    };
    let plan_id = plan.get("id").and_then(Value::as_str).unwrap_or_default();
    if plan.get("schema").and_then(Value::as_str) != Some(PLAN_SCHEMA)
        || plan.get("intent_id").and_then(Value::as_str) != Some(request.intent_id.as_str())
        || plan_id.is_empty()
        || request
            .requested_plan_id
            .as_deref()
            .is_some_and(|requested| requested != plan_id)
    {
        return refuse("plan_invalid", vec!["plan-identity-mismatch".to_string()]);
    }
    let snapshot = match plan.get("snapshot") {
        Some(Value::Object(snapshot)) => snapshot,
        _ => return refuse("plan_invalid", vec!["snapshot-missing".to_string()]),
    };
    let mut reasons = validate_snapshot(snapshot, request, plan_id);
    reasons.extend(validate_bound_revisions(&connection, snapshot));
    if !reasons.is_empty() {
        reasons.sort();
        reasons.dedup();
        return refuse("stale_plan", reasons);
    }
    let snapshot_digest = snapshot
        .get("snapshot_digest")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    PreflightOutcome::Admitted {
        schema: "narada.invokable-intelligence.preflight-admission.v1",
        intent_id: request.intent_id.clone(),
        plan_ref: plan_id.to_string(),
        snapshot_digest: snapshot_digest.clone(),
        selected: plan.get("selected").cloned().unwrap_or(Value::Null),
        evidence_ref: evidence_ref(plan_id, &snapshot_digest, request),
        checked_at: request.evaluated_at.clone(),
    }
}

fn resolve_semantic_intent(
    connection: &Connection,
    request: &PreflightRequest,
) -> Result<String, (&'static str, Vec<String>)> {
    let purpose = request.purpose.as_deref().unwrap_or_default();
    let mut statement = connection
        .prepare("SELECT id, doc FROM invocation_intents WHERE purpose = ?1 ORDER BY id")
        .map_err(|error| ("registry_read_failed", vec![error.to_string()]))?;
    let rows = statement
        .query_map([purpose], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| ("registry_read_failed", vec![error.to_string()]))?;
    let mut matches = Vec::new();
    for row in rows {
        let (id, doc) = row.map_err(|error| ("registry_read_failed", vec![error.to_string()]))?;
        let value: Value = serde_json::from_str(&doc)
            .map_err(|error| ("intent_invalid", vec![error.to_string()]))?;
        if request.principal.as_deref().is_none_or(|principal| {
            value.get("principal").and_then(Value::as_str) == Some(principal)
        }) {
            matches.push(id);
        }
    }
    match matches.as_slice() {
        [intent_id] => Ok(intent_id.clone()),
        [] => Err((
            "intent_not_found",
            vec!["no-exact-semantic-intent".to_string()],
        )),
        _ => Err((
            "intent_ambiguous",
            vec!["multiple-exact-semantic-intents".to_string()],
        )),
    }
}

fn validate_bound_revisions(
    connection: &Connection,
    snapshot: &serde_json::Map<String, Value>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let Some(revisions) = snapshot
        .get("referenced_revisions")
        .and_then(Value::as_array)
    else {
        return vec!["invalid-snapshot".to_string()];
    };
    for revision in revisions
        .iter()
        .filter(|revision| revision.get("kind").and_then(Value::as_str) != Some("materialization"))
    {
        let Some(record_id) = revision.get("record_id").and_then(Value::as_str) else {
            reasons.push("invalid-snapshot".to_string());
            continue;
        };
        let immutable_ref = revision.get("immutable_ref").and_then(Value::as_str);
        let current: Result<Option<(String, String)>, _> = connection.query_row(
            "SELECT id, doc FROM catalog_records WHERE record_id = ?1 ORDER BY revision DESC, id DESC LIMIT 1",
            [record_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional();
        match current {
            Ok(Some((id, doc))) if Some(id.as_str()) == immutable_ref => {
                let record = serde_json::from_str::<Value>(&doc).unwrap_or(Value::Null);
                let document = record.get("document").unwrap_or(&record);
                let digest = sha256_text(&canonical_json(document));
                if revision.get("digest").and_then(Value::as_str) != Some(digest.as_str()) {
                    reasons.push("catalog-changed".to_string());
                }
            }
            Ok(Some(_)) => reasons.push("catalog-changed".to_string()),
            Ok(None) => reasons.push("catalog-changed".to_string()),
            Err(_) => reasons.push("invalid-snapshot".to_string()),
        }
    }
    reasons
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => serde_json::to_string(value).unwrap(),
    }
}

fn sha256_text(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

fn load_plan(
    connection: &Connection,
    request: &PreflightRequest,
) -> Result<Option<String>, String> {
    let result = if let Some(plan_id) = request.requested_plan_id.as_deref() {
        connection
            .query_row(
                "SELECT doc FROM invocation_plans WHERE id = ?1 AND intent_id = ?2",
                (plan_id, request.intent_id.as_str()),
                |row| row.get(0),
            )
            .optional()
    } else {
        connection.query_row(
            "SELECT doc FROM invocation_plans WHERE intent_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
            [request.intent_id.as_str()],
            |row| row.get(0),
        ).optional()
    };
    result.map_err(|error| error.to_string())
}

fn validate_snapshot(
    snapshot: &serde_json::Map<String, Value>,
    request: &PreflightRequest,
    plan_id: &str,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if snapshot.get("schema").and_then(Value::as_str) != Some(SNAPSHOT_SCHEMA)
        || snapshot.get("plan_id").and_then(Value::as_str) != Some(plan_id)
        || snapshot.get("intent_id").and_then(Value::as_str) != Some(request.intent_id.as_str())
        || snapshot
            .get("clock")
            .and_then(|clock| clock.get("authority_ref"))
            .and_then(Value::as_str)
            .is_none()
        || snapshot
            .get("referenced_revisions")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        || snapshot
            .get("revalidation_triggers")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    {
        reasons.push("invalid-snapshot".to_string());
    }
    let Some(valid_until) = snapshot
        .get("valid_until")
        .and_then(Value::as_str)
        .and_then(parse_instant)
    else {
        reasons.push("invalid-snapshot".to_string());
        return reasons;
    };
    if parse_instant(&request.evaluated_at).expect("validated request instant") >= valid_until {
        reasons.push("plan-expired".to_string());
    }
    let Some(current_digests) = request.current_digests.as_ref() else {
        return reasons;
    };
    let expected = match serde_json::to_value(current_digests) {
        Ok(Value::Object(value)) => value,
        _ => return vec!["invalid-snapshot".to_string()],
    };
    let actual = snapshot.get("digests").and_then(Value::as_object);
    for (key, reason) in [
        ("normalized_resolver_input", "normalized-input-changed"),
        ("catalog", "catalog-changed"),
        ("policy", "policy-changed"),
        ("assertions", "assertions-changed"),
        ("topology", "topology-changed"),
        ("access", "access-changed"),
        ("materialization", "materialization-changed"),
    ] {
        if actual.and_then(|values| values.get(key)) != expected.get(key) {
            reasons.push(reason.to_string());
        }
    }
    let required_trigger = match request.mode.as_str() {
        "queued-batch" => Some("before-queued-attempt"),
        "delayed" => Some("at-scheduled-window"),
        "retry" => Some("before-retry"),
        "resume" => Some("before-resume"),
        "replay" => Some("before-replay"),
        _ => None,
    };
    if let Some(trigger) = required_trigger {
        let declared = snapshot
            .get("revalidation_triggers")
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(trigger)));
        if !declared {
            reasons.push("required-revalidation-trigger".to_string());
        }
    }
    reasons
}

fn valid_mode(value: &str) -> bool {
    matches!(
        value,
        "immediate" | "queued-batch" | "delayed" | "retry" | "resume" | "replay"
    )
}

fn parse_instant(value: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(value).ok()
}

fn digest_valid(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digests_valid(value: &ResolverDigests) -> bool {
    [
        &value.normalized_resolver_input,
        &value.catalog,
        &value.policy,
        &value.assertions,
        &value.topology,
        &value.access,
        &value.materialization,
    ]
    .into_iter()
    .all(|digest| digest_valid(digest))
}

fn evidence_ref(plan_id: &str, snapshot_digest: &str, request: &PreflightRequest) -> String {
    let mut digest = Sha256::new();
    for value in [
        plan_id,
        snapshot_digest,
        request.evaluated_at.as_str(),
        request.clock_authority_ref.as_str(),
    ] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    format!("preflight-evidence:{:x}", digest.finalize())
}
