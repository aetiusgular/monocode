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

/// `body` with `prelude` first: after a leading doctype, so the page keeps
/// standards mode, and otherwise at the very start, so no script of the page
/// runs before it. Comments are not skipped (security review L1): the HTML
/// parser ends a comment at `-->`, `--!>` and a few other forms, and a
/// skipper that misread one would put the prelude after page script. A page
/// that starts with a comment before its doctype loses standards mode, which
/// only changes how it lays out.
pub fn with_first_prelude(body: &str, prelude: &str) -> String {
    let at = after_leading_doctype(body).unwrap_or(0);
    let mut page = String::with_capacity(body.len() + prelude.len());
    page.push_str(&body[..at]);
    page.push_str(prelude);
    page.push_str(&body[at..]);
    page
}

/// The byte offset just past a doctype the page starts with, after an
/// optional byte order mark and whitespace. `None` when it does not start
/// with one, or the doctype has no closing `>`.
fn after_leading_doctype(body: &str) -> Option<usize> {
    let mut at = 0;
    if body.starts_with('\u{feff}') {
        at = '\u{feff}'.len_utf8();
    }
    let bytes = body.as_bytes();
    while at < bytes.len() && bytes[at].is_ascii_whitespace() {
        at += 1;
    }
    let rest = &body[at..];
    if rest.len() < 9 || !rest[..9].eq_ignore_ascii_case("<!doctype") {
        return None;
    }
    // A doctype has no markup inside it; `<` before `>` means it is not one.
    let end = rest.find('>')?;
    if rest[1..end].contains('<') {
        return None;
    }
    Some(at + end + 1)
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
    fn a_comment_first_puts_it_before_the_comment() {
        assert_eq!(
            with_first_prelude("<!-- made by an agent -->\n<!DOCTYPE html><p>", P),
            "<script>P</script><!-- made by an agent -->\n<!DOCTYPE html><p>"
        );
    }

    #[test]
    fn a_comment_closed_by_bang_cannot_put_page_script_first() {
        // L1: the parser ends this comment at `--!>`, so the page's script
        // runs; the prelude must still come before it.
        let page = "<!-- a --!><script>leak()</script><!-- b --><!DOCTYPE html><head>";
        let out = with_first_prelude(page, P);
        assert!(out.starts_with(P));
        assert!(out.find(P).unwrap() < out.find("leak()").unwrap());
    }

    #[test]
    fn a_doctype_holding_markup_is_not_taken_for_one() {
        let page = "<!doctype <script>leak()</script>>";
        assert!(with_first_prelude(page, P).starts_with(P));
    }

    #[test]
    fn a_byte_order_mark_and_whitespace_may_come_before_the_doctype() {
        assert_eq!(
            with_first_prelude("\u{feff}  <!DOCTYPE html><p>", P),
            "\u{feff}  <!DOCTYPE html><script>P</script><p>"
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
            "<script>P</script>  <html><body>"
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
