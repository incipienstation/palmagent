//! Numeric normalization at the public JSON boundary, matching JSON.parse/stringify.
//! Keep string escapes (including lone UTF-16 surrogates) opaque. The input has already
//! been validated as JSON by the read adapter; parsing it into serde Value would reject
//! historical payloads that JavaScript accepts. Duplicate keys retain last-value semantics.
pub fn normalize_numbers(json: String) -> String {
    let bytes = json.as_bytes();
    let mut output = String::with_capacity(json.len());
    let (mut index, mut copied) = (0, 0);
    while index < bytes.len() {
        if bytes[index] == b'"' {
            index += 1;
            while index < bytes.len() {
                if bytes[index] == b'\\' {
                    index += 2;
                } else if bytes[index] == b'"' {
                    index += 1;
                    break;
                } else {
                    index += 1;
                }
            }
        } else if bytes[index] == b'-' || bytes[index].is_ascii_digit() {
            let start = index;
            while index < bytes.len()
                && matches!(bytes[index], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
            {
                index += 1;
            }
            if let Ok(number) = json[start..index].parse::<f64>() {
                let replacement = if !number.is_finite() {
                    Some("null")
                } else if number == 0.0 && bytes[start] == b'-' {
                    Some("0")
                } else {
                    None
                };
                if let Some(replacement) = replacement {
                    output.push_str(&json[copied..start]);
                    output.push_str(replacement);
                    copied = index;
                }
            }
        } else {
            index += 1;
        }
    }
    if copied == 0 {
        return json;
    }
    output.push_str(&json[copied..]);
    output
}

// JavaScript permits isolated UTF-16 surrogates in strings. Keep these units
// reversible while a typed Rust queue is in memory. Escape the marker itself
// so all private-use text retains its original meaning on the next write.
const MARK: char = '\u{e000}';

pub fn protect_utf16(json: &str) -> std::borrow::Cow<'_, str> {
    if !json.contains(MARK) && !json.contains(r"\u") {
        return std::borrow::Cow::Borrowed(json);
    }
    let mut out = String::with_capacity(json.len());
    let mut chars = json.chars().peekable();
    while let Some(c) = chars.next() {
        if c == MARK {
            out.push(MARK);
            out.push(MARK);
            continue;
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(escape) = chars.next() else {
            out.push(c);
            break;
        };
        if escape != 'u' {
            out.push(c);
            out.push(escape);
            continue;
        }
        let digits: String = chars.by_ref().take(4).collect();
        let unit = u16::from_str_radix(&digits, 16).ok();
        if unit == Some(MARK as u16) {
            out.push(MARK);
            out.push(MARK);
            continue;
        }
        if let Some(unit @ 0xd800..=0xdfff) = unit {
            // Decode valid pairs normally so comparisons with literal text work.
            if unit <= 0xdbff {
                let mut next = chars.clone();
                if next.next() == Some('\\') && next.next() == Some('u') {
                    let low: String = next.by_ref().take(4).collect();
                    if let Ok(low @ 0xdc00..=0xdfff) = u16::from_str_radix(&low, 16) {
                        out.push(
                            char::from_u32(
                                0x10000 + ((unit as u32 - 0xd800) << 10) + (low as u32 - 0xdc00),
                            )
                            .unwrap(),
                        );
                        chars = next;
                        continue;
                    }
                }
            }
            out.push(MARK);
            out.push(char::from_u32(0xe100 + (unit as u32 - 0xd800)).unwrap());
            continue;
        }
        out.push_str("\\u");
        out.push_str(&digits);
    }
    std::borrow::Cow::Owned(out)
}

pub fn restore_utf16(json: String) -> String {
    if !json.contains(MARK) {
        return json;
    }
    use std::fmt::Write;
    let mut out = String::with_capacity(json.len());
    let mut chars = json.chars().peekable();
    while let Some(c) = chars.next() {
        if c == MARK {
            match chars.peek().copied() {
                Some(MARK) => {
                    chars.next();
                }
                Some(unit @ '\u{e100}'..='\u{e8ff}') => {
                    chars.next();
                    write!(out, "\\u{:04x}", 0xd800 + (unit as u32 - 0xe100)).unwrap();
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
    }
    out
}
