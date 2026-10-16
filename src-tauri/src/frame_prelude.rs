//! What every sandboxed frame of agent-written HTML runs first (security
//! review K3). The frames' content policies already block fetches, frames,
//! forms and loads from any host. Two channels are outside a content policy:
//! a WebRTC peer connection (its STUN host lookup can carry data) and DNS
//! prefetch. The prelude turns off DNS prefetch and removes the WebRTC
//! constructors before any script of the page runs. A nested frame would
//! bring a fresh window with its own constructors; `frame-src 'none'` does
//! not stop an `about:srcdoc` frame, so the prelude removes every nested
//! frame element as soon as it appears and hides the windows of any that
//! slip through (security review M2). This is best effort in the page: the
//! Mac test checks that no peer connection can be opened.

/// A meta tag and one script, inserted before anything else in the page.
pub const NO_NETWORK_PRELUDE: &str = concat!(
    r#"<meta http-equiv="x-dns-prefetch-control" content="off">"#,
    r#"<script>(function(){var w=window,n=["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCIceCandidate","RTCIceTransport","RTCSessionDescription","RTCCertificate"];for(var i=0;i<n.length;i++){try{Object.defineProperty(w,n[i],{value:undefined,writable:false,configurable:false});}catch(e){}}try{Object.defineProperty(navigator,"mediaDevices",{value:undefined,configurable:false});}catch(e){}"#,
    r#"try{var F="iframe,frame,object,embed,fencedframe,portal",rm=Element.prototype.remove,qa=Element.prototype.querySelectorAll,mt=Element.prototype.matches;var kill=function(x){if(!x||x.nodeType!==1)return;if(mt.call(x,F)){rm.call(x);return;}var q=qa.call(x,F);for(var j=0;j<q.length;j++)rm.call(q[j]);};new MutationObserver(function(ms){for(var a=0;a<ms.length;a++){var ad=ms[a].addedNodes;for(var b=0;b<ad.length;b++)kill(ad[b]);}}).observe(document,{childList:true,subtree:true});"#,
    r#"[HTMLIFrameElement,HTMLFrameElement,HTMLObjectElement,HTMLEmbedElement].forEach(function(C){if(!C)return;["contentWindow","contentDocument"].forEach(function(k){try{Object.defineProperty(C.prototype,k,{get:function(){return null;},configurable:false});}catch(e){}});});}catch(e){}})();</script>"#
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
    // Compared as bytes: a page whose ninth byte falls inside a multi-byte
    // character must not panic the scheme handler (security review M1).
    let rest = &bytes[at..];
    if !rest
        .get(..9)
        .is_some_and(|start| start.eq_ignore_ascii_case(b"<!doctype"))
    {
        return None;
    }
    let end = rest.iter().position(|&byte| byte == b'>')?;
    // Printable ASCII only, and no markup: anything else, such as an escape
    // that switches a decoder's character set, puts the prelude first
    // (security review M7).
    // Tab, line feeds and form feed may wrap a long doctype (N5).
    if !rest[1..end].iter().all(|&byte| {
        ((0x20..0x7f).contains(&byte) || matches!(byte, b'\t' | b'\n' | 0x0c | b'\r'))
            && byte != b'<'
    }) {
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
    fn a_multi_byte_character_near_the_start_does_not_panic() {
        // M1: byte 9 inside a multi-byte character.
        for page in [
            "<!-- Café menu -->\n<!DOCTYPE html><html>",
            "<!-- 日本語 -->\n<html>",
            "    \u{3000}<!doctype html>",
            "<!doctyp\u{e9} html>",
            "日本",
        ] {
            assert!(with_first_prelude(page, P).starts_with(P), "{page}");
        }
    }

    #[test]
    fn a_doctype_with_control_or_non_ascii_bytes_puts_it_first() {
        // M7: an escape that would switch a decoder's character set.
        assert!(with_first_prelude("<!doctype html\u{1b}$B>x", P).starts_with(P));
        assert!(with_first_prelude("<!doctype htm\u{e9}>x", P).starts_with(P));
        assert_eq!(
            with_first_prelude("<!DOCTYPE html PUBLIC \"-//W3C//DTD\">x", P),
            "<!DOCTYPE html PUBLIC \"-//W3C//DTD\"><script>P</script>x"
        );
        // A doctype wrapped onto a second line keeps standards mode (N5).
        assert_eq!(
            with_first_prelude("<!DOCTYPE html PUBLIC \"-//W3C//DTD\"\n\t\"x.dtd\">x", P),
            "<!DOCTYPE html PUBLIC \"-//W3C//DTD\"\n\t\"x.dtd\"><script>P</script>x"
        );
    }

    #[test]
    fn the_prelude_removes_nested_frames_and_hides_their_windows() {
        // M2: an about:srcdoc frame would bring its own constructors.
        assert!(NO_NETWORK_PRELUDE.contains("MutationObserver"));
        assert!(NO_NETWORK_PRELUDE.contains("iframe,frame,object,embed"));
        assert!(NO_NETWORK_PRELUDE.contains("contentWindow"));
        // One script element: nothing of the page can run between parts.
        assert_eq!(NO_NETWORK_PRELUDE.matches("<script>").count(), 1);
        assert_eq!(NO_NETWORK_PRELUDE.matches("</script>").count(), 1);
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
