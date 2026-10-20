//! Standard base64 (RFC 4648 section 4) decoding, for the PNG in a tool
//! result. The crate takes no dependency for it.

fn value(byte: u8) -> Option<u32> {
    Some(match byte {
        b'A'..=b'Z' => byte - b'A',
        b'a'..=b'z' => byte - b'a' + 26,
        b'0'..=b'9' => byte - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    } as u32)
}

/// The bytes `text` encodes, or None if it is not canonical padded base64.
/// No whitespace, no URL-safe alphabet, no missing padding.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let quads = bytes.len() / 4;
    for (index, quad) in bytes.chunks_exact(4).enumerate() {
        let last = index + 1 == quads;
        let pad = match quad {
            [_, _, b'=', b'='] if last => 2,
            [_, _, _, b'='] if last => 1,
            _ => 0,
        };
        let mut n = 0u32;
        for (at, byte) in quad.iter().enumerate() {
            let digit = if at >= 4 - pad { 0 } else { value(*byte)? };
            n = n << 6 | digit;
        }
        let three = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        // Bits under the padding must be zero (RFC 4648 section 3.5).
        if (pad == 1 && three[2] != 0) || (pad == 2 && (three[1] != 0 || three[2] != 0)) {
            return None;
        }
        out.extend_from_slice(&three[..3 - pad]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_the_rfc_4648_test_vectors() {
        // RFC 4648 section 10.
        for (plain, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(decode(encoded).unwrap(), plain.as_bytes(), "{encoded}");
        }
        assert_eq!(decode("+/8=").unwrap(), [0xfb, 0xff]);
        assert_eq!(
            decode("iVBORw0KGgpmYWtlLXBuZw==").unwrap(),
            b"\x89PNG\r\n\x1a\nfake-png"
        );
    }

    #[test]
    fn refuses_anything_not_canonical() {
        for bad in [
            "Zg", "Zg=", "Z===", "Zg==Zg==", "Zm9v\n", "Zm 9", "-_8=", "Zh==", "Zm9=", "====",
        ] {
            assert_eq!(decode(bad), None, "{bad:?}");
        }
    }
}
