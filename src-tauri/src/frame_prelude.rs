//! What every sandboxed frame of agent-written HTML runs first (security
//! review K3). The frames' content policies already block fetches, frames,
//! forms and loads from any host. Two channels are outside a content policy:
//! a WebRTC peer connection (its STUN host lookup can carry data) and DNS
//! prefetch. The prelude turns off DNS prefetch and removes the WebRTC
//! constructors before any script of the page runs, and the page cannot get
//! them back: it has no other frame or worker to take them from.

/// A meta tag and one script, inserted before anything else in the page.
pub const NO_NETWORK_PRELUDE: &str = concat!(
    r#"<meta http-equiv="x-dns-prefetch-control" content="off">"#,
    r#"<script>(function(){var w=window,n=["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCIceCandidate","RTCIceTransport","RTCSessionDescription","RTCCertificate"];for(var i=0;i<n.length;i++){try{Object.defineProperty(w,n[i],{value:undefined,writable:false,configurable:false});}catch(e){}}try{Object.defineProperty(navigator,"mediaDevices",{value:undefined,configurable:false});}catch(e){}})();</script>"#
);

/// `body` with `prelude` first: after the doctype and any comment or
/// whitespace before it, so the page keeps standards mode, and before every
/// tag of the page, so no script of the page runs before it.
pub fn with_first_prelude(body: &str, prelude: &str) -> String {
    let at = first_content(body);
    let mut page = String::with_capacity(body.len() + prelude.len());
    page.push_str(&body[..at]);
    page.push_str(prelude);
    page.push_str(&body[at..]);
    page
}

/// The byte offset just past a leading doctype, or, with none, just past the
/// whitespace and comments the page starts with.
fn first_content(body: &str) -> usize {
    let bytes = body.as_bytes();
    let mut at = 0;
    if body.starts_with('\u{feff}') {
        at = '\u{feff}'.len_utf8();
    }
    loop {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        let rest = &body[at..];
        if rest.starts_with("<!--") {
            match rest.find("-->") {
                Some(end) => at += end + 3,
                // An unclosed comment would hide the prelude; put it first.
                None => return 0,
            }
            continue;
        }
        if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case("<!doctype") {
            return match rest.find('>') {
                Some(end) => at + end + 1,
                None => 0,
            };
        }
        return at;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "<script>P</script>";

    #[test]
    fn goes_after_the_doctype_and_before_every_tag() {
        assert_eq!(
            with_first_prelude("<!DOCTYPE html><script>page()</script><html>", P),
            "<!DOCTYPE html><script>P</script><script>page()</script><html>"
        );
        assert_eq!(
            with_first_prelude("<!doctype html>\n<html><head><script>x</script>", P),
            "<!doctype html><script>P</script>\n<html><head><script>x</script>"
        );
    }

    #[test]
    fn keeps_leading_comments_before_the_doctype() {
        assert_eq!(
            with_first_prelude("<!-- made by an agent -->\n<!DOCTYPE html><p>", P),
            "<!-- made by an agent -->\n<!DOCTYPE html><script>P</script><p>"
        );
    }

    #[test]
    fn a_fragment_or_a_page_with_no_doctype_gets_it_at_the_start() {
        assert_eq!(
            with_first_prelude("<script>page()</script>", P),
            "<script>P</script><script>page()</script>"
        );
        assert_eq!(
            with_first_prelude("  <html><body>", P),
            "  <script>P</script><html><body>"
        );
        assert_eq!(with_first_prelude("", P), P);
    }

    #[test]
    fn an_unclosed_comment_or_doctype_puts_it_first() {
        assert_eq!(
            with_first_prelude("<!-- no end <script>x</script>", P),
            "<script>P</script><!-- no end <script>x</script>"
        );
        assert_eq!(
            with_first_prelude("<!DOCTYPE html", P),
            "<script>P</script><!DOCTYPE html"
        );
    }

    #[test]
    fn the_prelude_turns_off_dns_prefetch_and_webrtc() {
        assert!(NO_NETWORK_PRELUDE
            .starts_with(r#"<meta http-equiv="x-dns-prefetch-control" content="off">"#));
        for name in [
            "RTCPeerConnection",
            "webkitRTCPeerConnection",
            "RTCDataChannel",
        ] {
            assert!(NO_NETWORK_PRELUDE.contains(&format!("\"{name}\"")));
        }
        assert!(NO_NETWORK_PRELUDE.contains("configurable:false"));
        assert!(NO_NETWORK_PRELUDE.contains("mediaDevices"));
    }
}
