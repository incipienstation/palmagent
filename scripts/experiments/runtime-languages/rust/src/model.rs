//! Experimental port of the existing TypeScript projection; not application code.
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::collections::HashSet;

const MAX_TEXT_UNITS: usize = 160;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Text(Vec<u16>);

impl Serialize for Text {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if let Ok(s) = String::from_utf16(&self.0) {
            return serializer.serialize_str(&s);
        }
        // JS slice may truncate an astral character between its surrogate units.
        let prefix = String::from_utf16(&self.0[..self.0.len() - 1]).unwrap();
        let mut json = serde_json::to_string(&prefix).unwrap();
        json.pop();
        json.push_str(&format!("\\u{:04x}\"", self.0.last().unwrap()));
        serde_json::value::RawValue::from_string(json)
            .unwrap()
            .serialize(serializer)
    }
}

#[derive(Clone, Serialize)]
pub struct Choice {
    value: Text,
    label: Text,
}
#[derive(Serialize)]
pub struct Model {
    #[serde(flatten)]
    choice: Choice,
    efforts: Vec<Choice>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    agent: &'static str,
    source: &'static str,
    fetched_at: u64,
    models: Vec<Model>,
}

fn js_space(c: char) -> bool {
    matches!(c as u32, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn text(value: &Value) -> Option<Text> {
    let s = value.as_str()?.trim_matches(js_space);
    let mut normalized = String::new();
    let mut space = false;
    for c in s.chars() {
        if matches!(c, '\t' | '\r' | '\n' | ' ') {
            if !space {
                normalized.push(' ');
            }
            space = true;
        } else {
            normalized.push(c);
            space = false;
        }
    }
    let units: Vec<u16> = normalized.encode_utf16().take(MAX_TEXT_UNITS).collect();
    if units.is_empty() {
        None
    } else {
        Some(Text(units))
    }
}
fn choice(value: Text) -> Choice {
    Choice {
        label: value.clone(),
        value,
    }
}
fn default_choice() -> Choice {
    choice(Text("default".encode_utf16().collect()))
}
fn coalesce<'a>(values: &[&'a Value]) -> &'a Value {
    values
        .iter()
        .copied()
        .find(|v| !v.is_null())
        .unwrap_or(&Value::Null)
}
fn efforts(value: &Value) -> Vec<Choice> {
    let mut out = vec![default_choice()];
    let mut seen = HashSet::from([out[0].value.clone()]);
    for item in value.as_array().into_iter().flatten().take(64) {
        let value = if item.is_string() {
            item
        } else {
            coalesce(&[&item["reasoningEffort"], &item["effort"], &item["value"]])
        };
        if let Some(t) = text(value) {
            if seen.insert(t.clone()) {
                out.push(choice(t));
            }
        }
    }
    out
}
pub fn parse(value: &Value) -> Option<Catalog> {
    let rows = value["data"]
        .as_array()
        .or_else(|| value["models"].as_array());
    let mut models = Vec::new();
    let mut seen = HashSet::from([default_choice().value]);
    let mut delegate = vec![default_choice()];
    for row in rows.into_iter().flatten().take(128) {
        if row["hidden"] == true {
            continue;
        }
        let Some(t) = text(coalesce(&[&row["model"], &row["id"]])) else {
            continue;
        };
        if !seen.insert(t.clone()) {
            continue;
        }
        let projected = Model {
            choice: choice(t),
            efforts: efforts(&row["supportedReasoningEfforts"]),
        };
        if row["isDefault"] == true {
            delegate = projected.efforts.clone();
        }
        models.push(projected);
    }
    if models.is_empty() {
        return None;
    }
    models.insert(
        0,
        Model {
            choice: default_choice(),
            efforts: delegate,
        },
    );
    Some(Catalog {
        agent: "codex",
        source: "runtime",
        fetched_at: 123,
        models,
    })
}
