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
