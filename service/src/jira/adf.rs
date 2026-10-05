//! ADF ⇄ text (R17-C): the fork's `src/main/jira/adf-markdown.ts`,
//! ported to the daemon so issue descriptions and comment bodies arrive at
//! the renderer as markdown (the fork renders Jira bodies as Markdown).
//! `text_to_adf` is the create/comment write path: REST v3 (Cloud) requires
//! ADF documents, v2 (Server/DC) takes plain text — the fork's `toBodyText`.
//! MIT Copyright (c) 2026 Lovecast Inc.

use serde_json::Value;
use std::borrow::Cow;

fn as_record(value: Option<&Value>) -> Cow<'_, serde_json::Map<String, Value>> {
    match value.and_then(Value::as_object) {
        Some(map) => Cow::Borrowed(map),
        None => Cow::Owned(serde_json::Map::new()),
    }
}

fn as_array(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn as_string(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn positive_integer(value: Option<&Value>, fallback: u64) -> u64 {
    match value.and_then(Value::as_u64) {
        Some(number) if number > 0 => number,
        _ => fallback,
    }
}

fn escape_markdown_alt(text: &str) -> String {
    text.replace(['[', ']'], "")
}

/// The fork's `textNode`: empty text becomes a hardBreak so blank lines
/// survive the round trip as empty paragraphs.
fn text_node(text: &str) -> Value {
    if text.is_empty() {
        serde_json::json!({ "type": "hardBreak" })
    } else {
        serde_json::json!({ "type": "text", "text": text })
    }
}

/// The fork's `textToAdf`: one paragraph per line, CR trimmed the same way
/// as the renderer's `buildJiraCreateTextAdf`.
pub fn text_to_adf(text: &str) -> Value {
    let content: Vec<Value> = text
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            serde_json::json!({
                "type": "paragraph",
                "content": if line.is_empty() { vec![] } else { vec![text_node(line)] },
            })
        })
        .collect();
    serde_json::json!({ "type": "doc", "version": 1, "content": content })
}

/// REST v2 (Server/DC) bodies are plain text; v3 (Cloud) requires ADF
/// documents — the fork's `toBodyText`.
pub fn to_body_text(auth_type: crate::protocol::jira::JiraAuthType, text: &str) -> Value {
    use crate::protocol::jira::JiraAuthType;
    match auth_type {
        JiraAuthType::Server => Value::String(text.to_string()),
        JiraAuthType::Cloud => text_to_adf(text),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    Block,
    List,
}

#[derive(Debug, Clone)]
struct MarkdownBlock {
    kind: BlockKind,
    text: String,
}

/// The fork's `unresolvedMediaPlaceholder`: a visible italic marker so
/// screenshots are not silently dropped from the issue body. Binary
/// attachment plumbing is not ported (R17-C); media without an http(s) url
/// renders as this marker, exactly like the fork without a media resolver.
fn unresolved_media_placeholder(alt: &str) -> String {
    let label = escape_markdown_alt(if alt.trim().is_empty() {
        "Image"
    } else {
        alt.trim()
    });
    format!("*[{label}]*")
}

fn media_attrs(record: &serde_json::Map<String, Value>) -> (String, String) {
    let attrs = as_record(record.get("attrs"));
    let alt = {
        let alt = as_string(attrs.get("alt"));
        if alt.is_empty() {
            as_string(attrs.get("name"))
        } else {
            alt
        }
    }
    .to_string();
    let url = as_string(attrs.get("url")).to_string();
    (alt, url)
}

fn render_media_markdown(record: &serde_json::Map<String, Value>) -> String {
    let (alt, url) = media_attrs(record);
    if !url.is_empty() && (url.starts_with("http://") || url.starts_with("https://")) {
        // The destination sanitizer in the fork escapes unsafe URL
        // characters; the fixture and Jira both serve plain https urls.
        let safe = url
            .replace(' ', "%20")
            .replace('(', "%28")
            .replace(')', "%29");
        return format!(
            "![{}]({safe})",
            escape_markdown_alt(if alt.trim().is_empty() {
                "Image"
            } else {
                alt.trim()
            })
        );
    }
    unresolved_media_placeholder(&alt)
}

fn render_inline(node: Option<&Value>) -> String {
    match node {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items.iter().map(|item| render_inline(Some(item))).collect(),
        Some(Value::Object(record)) => {
            if let Some(text) = record.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            if record.get("type").and_then(Value::as_str) == Some("hardBreak") {
                return "\n".to_string();
            }
            if matches!(
                record.get("type").and_then(Value::as_str),
                Some("media") | Some("mediaInline")
            ) {
                return render_media_markdown(record);
            }
            let attrs = as_record(record.get("attrs"));
            for key in ["text", "shortName", "url"] {
                let fallback = as_string(attrs.get(key));
                if !fallback.is_empty() {
                    return fallback.to_string();
                }
            }
            render_inline(record.get("content"))
        }
        Some(_) => String::new(),
    }
}

fn join_blocks(blocks: &[MarkdownBlock]) -> String {
    blocks
        .iter()
        .map(|block| block.text.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_blocks(content: Option<&Value>) -> Vec<MarkdownBlock> {
    as_array(content)
        .iter()
        .map(render_block)
        .filter(|block| !block.text.is_empty())
        .collect()
}

fn render_list_item(node: &Value, prefix: &str) -> String {
    let record = as_record(Some(node));
    let blocks = render_blocks(record.get("content"));
    if blocks.is_empty() {
        return prefix.trim_end().to_string();
    }
    let continuation_indent = " ".repeat(prefix.len());
    let mut lines: Vec<String> = Vec::new();
    for (block_index, block) in blocks.iter().enumerate() {
        let block_lines: Vec<&str> = block.text.split('\n').collect();
        if block_index == 0 {
            lines.push(
                format!("{}{}", prefix, block_lines.first().copied().unwrap_or(""))
                    .trim_end()
                    .to_string(),
            );
            for line in &block_lines[1..] {
                lines.push(
                    format!("{continuation_indent}{line}")
                        .trim_end()
                        .to_string(),
                );
            }
            continue;
        }
        if block.kind != BlockKind::List {
            lines.push(String::new());
        }
        for line in block_lines {
            lines.push(
                format!("{continuation_indent}{line}")
                    .trim_end()
                    .to_string(),
            );
        }
    }
    lines.join("\n")
}

fn render_list(record: &serde_json::Map<String, Value>, ordered: bool) -> String {
    let start = if ordered {
        positive_integer(as_record(record.get("attrs")).get("order"), 1)
    } else {
        1
    };
    as_array(record.get("content"))
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let prefix = if ordered {
                format!("{}. ", start + index as u64)
            } else {
                "- ".to_string()
            };
            render_list_item(item, &prefix)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_code_block(record: &serde_json::Map<String, Value>) -> MarkdownBlock {
    let text = render_inline(record.get("content"));
    let text = text.strip_suffix('\n').unwrap_or(&text);
    MarkdownBlock {
        kind: BlockKind::Block,
        text: ["```", text, "```"].join("\n"),
    }
}

fn render_blockquote(record: &serde_json::Map<String, Value>) -> MarkdownBlock {
    let text = join_blocks(&render_blocks(record.get("content")));
    MarkdownBlock {
        kind: BlockKind::Block,
        text: text
            .split('\n')
            .map(|line| format!("> {line}").trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn heading_level(record: &serde_json::Map<String, Value>) -> usize {
    let level = positive_integer(as_record(record.get("attrs")).get("level"), 1);
    (level.clamp(1, 6)) as usize
}

fn render_block(node: &Value) -> MarkdownBlock {
    match node {
        Value::String(text) => MarkdownBlock {
            kind: BlockKind::Block,
            text: text.clone(),
        },
        Value::Array(items) => MarkdownBlock {
            kind: BlockKind::Block,
            text: join_blocks(&items.iter().map(render_block).collect::<Vec<_>>()),
        },
        Value::Object(record) => {
            let r#type = as_string(record.get("type"));
            match r#type {
                "doc" => MarkdownBlock {
                    kind: BlockKind::Block,
                    text: join_blocks(&render_blocks(record.get("content"))),
                },
                "paragraph" => MarkdownBlock {
                    kind: BlockKind::Block,
                    text: render_inline(record.get("content")),
                },
                "heading" => {
                    let prefix = "#".repeat(heading_level(record));
                    let body = render_inline(record.get("content"));
                    MarkdownBlock {
                        kind: BlockKind::Block,
                        text: format!("{prefix} {}", body.trim()).trim().to_string(),
                    }
                }
                "bulletList" => MarkdownBlock {
                    kind: BlockKind::List,
                    text: render_list(record, false),
                },
                "orderedList" => MarkdownBlock {
                    kind: BlockKind::List,
                    text: render_list(record, true),
                },
                "listItem" => MarkdownBlock {
                    kind: BlockKind::List,
                    text: render_list_item(node, "- "),
                },
                "codeBlock" => render_code_block(record),
                "blockquote" => render_blockquote(record),
                "rule" => MarkdownBlock {
                    kind: BlockKind::Block,
                    text: "---".to_string(),
                },
                "mediaSingle" | "mediaGroup" => MarkdownBlock {
                    kind: BlockKind::Block,
                    text: join_blocks(&render_blocks(record.get("content"))),
                },
                "media" | "mediaInline" => MarkdownBlock {
                    kind: BlockKind::Block,
                    text: render_media_markdown(record),
                },
                _ => {
                    let joined = join_blocks(&render_blocks(record.get("content")));
                    let inline = render_inline(record.get("content"));
                    MarkdownBlock {
                        kind: BlockKind::Block,
                        text: if joined.is_empty() { inline } else { joined },
                    }
                }
            }
        }
        _ => MarkdownBlock {
            kind: BlockKind::Block,
            text: String::new(),
        },
    }
}

/// The fork's `adfToMarkdownText`: render one ADF value to markdown, then
/// normalize trailing whitespace and collapse 3+ newlines the same way.
/// Server/DC comment bodies are wiki markup, not ADF; a bare string passes
/// through as its own text.
pub fn adf_to_markdown_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(other) => normalize(&render_block(other).text),
        None => String::new(),
    }
}

fn normalize(text: &str) -> String {
    // The fork: `.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()`.
    // Newlines are the only structural character here, so buffer runs of
    // spaces and drop them when a newline (or the end) follows; collapse
    // 3+ newlines to exactly two; trim the ends.
    let mut out = String::with_capacity(text.len());
    let mut pending_spaces = 0usize;
    let mut pending_newlines = 0usize;
    for ch in text.chars() {
        match ch {
            ' ' | '\t' => pending_spaces += 1,
            '\n' => {
                pending_spaces = 0;
                pending_newlines += 1;
            }
            _ => {
                if pending_newlines > 0 {
                    out.push('\n');
                    if pending_newlines >= 2 {
                        out.push('\n');
                    }
                    // Leading indentation after a newline is significant
                    // (list continuation indents) — keep the buffered
                    // spaces; the fork's regex only drops spaces that run
                    // INTO a newline.
                    for _ in 0..pending_spaces {
                        out.push(' ');
                    }
                } else {
                    for _ in 0..pending_spaces {
                        out.push(' ');
                    }
                }
                pending_spaces = 0;
                pending_newlines = 0;
                out.push(ch);
            }
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn md(value: Value) -> String {
        adf_to_markdown_text(Some(&value))
    }

    #[test]
    fn paragraphs_join_with_blank_lines() {
        let adf = json!({
            "type": "doc",
            "version": 1,
            "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "First" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "Second" }] }
            ]
        });
        assert_eq!(md(adf), "First\n\nSecond");
    }

    #[test]
    fn headings_levels_and_trim() {
        let adf = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 },
                  "content": [{ "type": "text", "text": "  Plan  " }] }
            ]
        });
        assert_eq!(md(adf), "## Plan");
        let adf = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 9 },
                  "content": [{ "type": "text", "text": "Deep" }] }
            ]
        });
        assert_eq!(md(adf), "###### Deep");
    }

    #[test]
    fn bullet_and_ordered_lists() {
        let adf = json!({
            "type": "bulletList",
            "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "one" }] }] },
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }] }
            ]
        });
        assert_eq!(md(adf), "- one\n- two");
        let adf = json!({
            "type": "orderedList", "attrs": { "order": 3 },
            "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "third" }] }] }
            ]
        });
        assert_eq!(md(adf), "3. third");
    }

    #[test]
    fn nested_list_continuations_indent() {
        let adf = json!({
            "type": "bulletList",
            "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "parent" }] },
                    { "type": "bulletList", "content": [
                        { "type": "listItem", "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": "child" }] }] }
                    ] }
                ] }
            ]
        });
        assert_eq!(md(adf), "- parent\n  - child");
    }

    #[test]
    fn code_block_and_blockquote_and_rule() {
        let adf = json!({
            "type": "doc",
            "content": [
                { "type": "codeBlock", "content": [{ "type": "text", "text": "let x = 1;\n" }] },
                { "type": "blockquote", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "quoted" }] }
                ] },
                { "type": "rule" }
            ]
        });
        assert_eq!(md(adf), "```\nlet x = 1;\n```\n\n> quoted\n\n---");
    }

    #[test]
    fn hard_breaks_and_media_placeholders() {
        let adf = json!({
            "type": "paragraph",
            "content": [
                { "type": "text", "text": "line one" },
                { "type": "hardBreak" },
                { "type": "text", "text": "line two" }
            ]
        });
        assert_eq!(md(adf), "line one\nline two");
        // Media without a resolver or an external url keeps a visible marker.
        let media = json!({
            "type": "mediaSingle",
            "content": [{ "type": "media", "attrs": { "id": "attach-1", "alt": "Screen shot" } }]
        });
        assert_eq!(md(media), "*[Screen shot]*");
        // An http(s) url renders as an image the way the fork does without a
        // media resolver.
        let media = json!({
            "type": "media",
            "attrs": { "url": "https://fixture.local/attach.png", "alt": "diag" }
        });
        assert_eq!(md(media), "![diag](https://fixture.local/attach.png)");
    }

    #[test]
    fn collapses_excess_newlines_and_trailing_space() {
        let adf = json!({
            "type": "paragraph",
            "content": [{ "type": "text", "text": "a   \n\n\n\nb" }]
        });
        assert_eq!(md(adf), "a\n\nb");
    }

    #[test]
    fn plain_string_bodies_pass_through() {
        assert_eq!(
            adf_to_markdown_text(Some(&json!("wiki *markup*"))),
            "wiki *markup*"
        );
        assert_eq!(adf_to_markdown_text(None), "");
    }

    #[test]
    fn text_to_adf_splits_lines_like_the_fork() {
        let adf = text_to_adf("one\r\ntwo\n\nthree");
        assert_eq!(adf["type"], "doc");
        assert_eq!(adf["version"], 1);
        let content = adf["content"].as_array().unwrap();
        assert_eq!(content.len(), 4);
        assert_eq!(content[0]["content"][0]["text"], "one");
        assert_eq!(content[1]["content"][0]["text"], "two");
        assert_eq!(content[2]["content"], serde_json::json!([]));
        assert_eq!(content[3]["content"][0]["text"], "three");
    }

    #[test]
    fn to_body_text_splits_by_deployment() {
        use crate::protocol::jira::JiraAuthType;
        let cloud = to_body_text(JiraAuthType::Cloud, "hello");
        assert_eq!(cloud["type"], "doc");
        let server = to_body_text(JiraAuthType::Server, "hello");
        assert_eq!(server, json!("hello"));
    }
}
