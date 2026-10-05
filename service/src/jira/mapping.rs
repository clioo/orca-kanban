//! Jira REST record → contract mapping (R17-A), ported from the fork's
//! `src/main/jira/jira-issue-mapping.ts` and `jira-record-pages.ts`.
//! List mapping deliberately omits `description` (ADF parse is the hot-path
//! cost the fork avoids on the list path).
//! MIT Copyright (c) 2026 Lovecast Inc.

use crate::protocol::jira::*;

/// The fork's `ISSUE_FIELDS`; `ISSUE_LIST_FIELDS` drops `description`.
pub const ISSUE_FIELDS: [&str; 11] = [
    "summary",
    "description",
    "project",
    "issuetype",
    "status",
    "assignee",
    "reporter",
    "priority",
    "labels",
    "created",
    "updated",
];

pub const ISSUE_LIST_FIELDS: [&str; 10] = [
    "summary",
    "project",
    "issuetype",
    "status",
    "assignee",
    "reporter",
    "priority",
    "labels",
    "created",
    "updated",
];

/// Borrowed when the value is an object, owned-empty otherwise, so the
/// fallback never dangles and callers never clone the common case.
pub fn as_record(
    value: Option<&serde_json::Value>,
) -> std::borrow::Cow<'_, serde_json::Map<String, serde_json::Value>> {
    match value.and_then(serde_json::Value::as_object) {
        Some(map) => std::borrow::Cow::Borrowed(map),
        None => std::borrow::Cow::Owned(serde_json::Map::new()),
    }
}

pub fn as_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn as_string_or(value: Option<&serde_json::Value>, fallback: &str) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub fn as_string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn avatar_url(value: Option<&serde_json::Value>) -> Option<String> {
    let avatars = as_record(value);
    ["48x48", "32x32", "24x24"]
        .iter()
        .find_map(|key| avatars.get(*key).and_then(serde_json::Value::as_str))
        .map(str::to_string)
}

/// Server/DC users have no accountId; name (login) and key are its stable
/// ids — the fork's `mapUser`.
pub fn map_user(value: Option<&serde_json::Value>) -> Option<JiraUser> {
    let user = as_record(value);
    let account_id = user
        .get("accountId")
        .and_then(serde_json::Value::as_str)
        .or_else(|| user.get("name").and_then(serde_json::Value::as_str))
        .or_else(|| user.get("key").and_then(serde_json::Value::as_str))?;
    Some(JiraUser {
        account_id: account_id.to_string(),
        display_name: as_string_or(user.get("displayName"), "Unknown"),
        email: user
            .get("emailAddress")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        avatar_url: avatar_url(user.get("avatarUrls")),
    })
}

pub fn map_project(value: Option<&serde_json::Value>, site: Option<&JiraSite>) -> JiraProject {
    let project = as_record(value);
    let key = as_string(project.get("key"));
    JiraProject {
        id: as_string(project.get("id")),
        key: key.clone(),
        name: as_string_or(project.get("name"), &key),
        site_id: site.map(|site| site.id.clone()),
        site_name: site.map(|site| site.display_name.clone()),
    }
}

pub fn map_issue_type(value: Option<&serde_json::Value>) -> JiraIssueType {
    let issue_type = as_record(value);
    JiraIssueType {
        id: as_string(issue_type.get("id")),
        name: as_string_or(issue_type.get("name"), "Issue"),
        description: issue_type
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        icon_url: issue_type
            .get("iconUrl")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        subtask: issue_type
            .get("subtask")
            .and_then(serde_json::Value::as_bool),
    }
}

pub fn map_create_field_allowed_value(value: &serde_json::Value) -> JiraCreateFieldAllowedValue {
    let option = as_record(Some(value));
    let pick = |key: &str| {
        option
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    JiraCreateFieldAllowedValue {
        id: pick("id"),
        value: pick("value"),
        name: pick("name"),
    }
}

/// The fork's `mapCreateField`; `None` when no usable field key exists.
pub fn map_create_field(value: &serde_json::Value, fallback_key: &str) -> Option<JiraCreateField> {
    let field = as_record(Some(value));
    let schema = as_record(field.get("schema"));
    let schema = schema.as_ref();
    let key = field
        .get("key")
        .and_then(serde_json::Value::as_str)
        .or_else(|| field.get("fieldId").and_then(serde_json::Value::as_str))
        .or_else(|| field.get("id").and_then(serde_json::Value::as_str))
        .or_else(|| field.get("fieldKey").and_then(serde_json::Value::as_str))
        .filter(|key| !key.is_empty())
        .unwrap_or(fallback_key);
    if key.is_empty() {
        return None;
    }
    let pick = |map: &serde_json::Map<String, serde_json::Value>, name: &str| {
        map.get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Some(JiraCreateField {
        key: key.to_string(),
        name: as_string_or(field.get("name"), key),
        required: field
            .get("required")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        schema: if schema.is_empty() {
            None
        } else {
            Some(JiraCreateFieldSchema {
                r#type: pick(schema, "type"),
                items: pick(schema, "items"),
                custom: pick(schema, "custom"),
            })
        },
        allowed_values: field
            .get("allowedValues")
            .and_then(serde_json::Value::as_array)
            .map(|values| values.iter().map(map_create_field_allowed_value).collect()),
    })
}

/// The createmeta field list arrives as `values`, `fields` (array), or a
/// `fields` object keyed by field id — the fork's `getCreateFieldRecords`.
pub fn get_create_field_records(response: &serde_json::Value) -> Vec<serde_json::Value> {
    if let Some(values) = response.get("values").and_then(serde_json::Value::as_array) {
        return values.clone();
    }
    if let Some(fields) = response.get("fields").and_then(serde_json::Value::as_array) {
        return fields.clone();
    }
    if let Some(fields) = response
        .get("fields")
        .and_then(serde_json::Value::as_object)
    {
        return fields
            .iter()
            .map(|(key, value)| {
                let mut record: serde_json::Map<String, serde_json::Value> =
                    as_record(Some(value)).into_owned();
                record.insert("key".to_string(), serde_json::Value::String(key.clone()));
                serde_json::Value::Object(record)
            })
            .collect();
    }
    Vec::new()
}

pub fn map_priority(value: Option<&serde_json::Value>) -> Option<JiraPriority> {
    let priority = as_record(value);
    let id = priority.get("id")?;
    let id = match id {
        serde_json::Value::String(id) if !id.is_empty() => id.clone(),
        serde_json::Value::Number(number) => number.to_string(),
        _ => return None,
    };
    Some(JiraPriority {
        id,
        name: as_string_or(priority.get("name"), "Priority"),
        icon_url: priority
            .get("iconUrl")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    })
}

pub fn map_status(value: Option<&serde_json::Value>) -> JiraStatus {
    let status = as_record(value);
    let category = as_record(status.get("statusCategory"));
    JiraStatus {
        id: as_string(status.get("id")),
        name: as_string_or(status.get("name"), "Unknown"),
        category_key: as_string_or(category.get("key"), "undefined"),
        category_name: as_string_or(category.get("name"), "No Category"),
        color_name: status
            .get("colorName")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    }
}

pub fn issue_url(site: &JiraSite, key: &str) -> String {
    format!("{}/browse/{}", site.site_url, key)
}

/// List-path issue mapping: everything the Tasks list needs, with the
/// fork's "now" fallback for missing timestamps (never a silent null).
pub fn map_jira_issue(site: &JiraSite, raw: &serde_json::Value) -> JiraIssue {
    let fields = as_record(raw.get("fields"));
    let key = as_string(raw.get("key"));
    let fallback_now = humantime_fallback();
    JiraIssue {
        id: as_string_or(raw.get("id"), &key),
        key: key.clone(),
        site_id: Some(site.id.clone()),
        site_name: Some(site.display_name.clone()),
        title: as_string_or(
            fields.get("summary"),
            if key.is_empty() {
                "Untitled issue"
            } else {
                &key
            },
        ),
        // List mapping deliberately omits `description` (ADF parse is the
        // hot-path cost the fork avoids on the list path); the R17-C
        // detail mapper fills it.
        description: None,
        url: issue_url(site, &key),
        project: map_project(fields.get("project"), Some(site)),
        issue_type: map_issue_type(fields.get("issuetype")),
        status: map_status(fields.get("status")),
        labels: as_string_array(fields.get("labels")),
        assignee: map_user(fields.get("assignee")),
        reporter: map_user(fields.get("reporter")),
        priority: map_priority(fields.get("priority")),
        created_at: as_string_or(fields.get("created"), &fallback_now),
        updated_at: as_string_or(fields.get("updated"), &fallback_now),
    }
}

fn humantime_fallback() -> String {
    // The fork falls back to `new Date().toISOString()`; Drogon formats UTC
    // itself instead of pulling a time crate.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site() -> JiraSite {
        JiraSite {
            id: "s1".to_string(),
            site_url: "https://example.atlassian.net".to_string(),
            email: "me@example.com".to_string(),
            display_name: "Example".to_string(),
            account_id: "acct".to_string(),
            auth_type: JiraAuthType::Cloud,
        }
    }

    #[test]
    fn maps_a_full_issue() {
        let raw = serde_json::json!({
            "id": "10001",
            "key": "ABC-7",
            "fields": {
                "summary": "Do the thing",
                "project": {"id": "10", "key": "ABC", "name": "Alphabet"},
                "issuetype": {"id": "1", "name": "Task"},
                "status": {"id": "3", "name": "Backlog",
                           "statusCategory": {"key": "new", "name": "To Do"}},
                "assignee": {"accountId": "u1", "displayName": "Me",
                             "avatarUrls": {"48x48": "https://a/48"}},
                "priority": {"id": "2", "name": "High"},
                "labels": ["backend"],
                "created": "2026-01-01T00:00:00.000Z",
                "updated": "2026-02-01T00:00:00.000Z"
            }
        });
        let issue = map_jira_issue(&site(), &raw);
        assert_eq!(issue.key, "ABC-7");
        assert_eq!(issue.title, "Do the thing");
        assert_eq!(issue.url, "https://example.atlassian.net/browse/ABC-7");
        assert_eq!(issue.status.category_key, "new");
        assert_eq!(issue.priority.unwrap().name, "High");
        assert_eq!(issue.assignee.unwrap().account_id, "u1");
        assert_eq!(issue.labels, vec!["backend".to_string()]);
        assert_eq!(issue.project.key, "ABC");
        assert_eq!(issue.site_id.as_deref(), Some("s1"));
    }

    #[test]
    fn missing_assignee_and_priority_map_to_none() {
        let raw = serde_json::json!({
            "key": "ABC-8",
            "fields": {"summary": "x"}
        });
        let issue = map_jira_issue(&site(), &raw);
        assert!(issue.assignee.is_none());
        assert!(issue.priority.is_none());
        assert!(issue.reporter.is_none());
        assert!(issue.labels.is_empty());
        // Timestamps fall back to "now", never to null.
        assert!(issue.updated_at.ends_with('Z'));
    }

    #[test]
    fn list_fields_exclude_description_but_keep_updated() {
        assert!(!ISSUE_LIST_FIELDS.contains(&"description"));
        assert!(ISSUE_LIST_FIELDS.contains(&"updated"));
    }

    #[test]
    fn create_field_records_accept_values_array_fields_array_and_fields_object() {
        let from_values = get_create_field_records(&serde_json::json!({"values": [{"key": "a"}]}));
        assert_eq!(from_values.len(), 1);
        let from_array = get_create_field_records(&serde_json::json!({"fields": [{"key": "b"}]}));
        assert_eq!(from_array.len(), 1);
        let from_object =
            get_create_field_records(&serde_json::json!({"fields": {"custom_1": {"name": "C"}}}));
        assert_eq!(from_object.len(), 1);
        assert_eq!(from_object[0]["key"], "custom_1");
    }
}
