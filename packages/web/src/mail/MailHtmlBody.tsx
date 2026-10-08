import type { MailMessage } from "@argelanderspace/contracts";
import { useEffect, useMemo, useState } from "react";
import { mailAttachmentUrl } from "../api/mail";
import { buildMailSrcDoc, MAIL_FRAME_SANDBOX, type SanitizedMail, sanitizeMailHtml } from "./sanitize";

const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

/**
 * `cid:` images as data: URIs. The sandboxed frame has an opaque origin and cannot fetch from the app, so
 * the top page fetches the bytes (raster types only, size-capped) and embeds them.
 */
export function useInlineImages(message: MailMessage): Map<string, string> {
  const [images, setImages] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    setImages(new Map());
    const wanted = message.attachments.filter(
      (a) => a.contentId && INLINE_IMAGE.test(a.contentType) && a.size <= MAX_INLINE_BYTES
    );
    for (const a of wanted) {
      void (async () => {
        try {
          const r = await fetch(mailAttachmentUrl(message.accountId, message, a.part, true));
          if (!r.ok) return;
          const bytes = new Uint8Array(await r.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000)
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const uri = `data:${a.contentType.toLowerCase()};base64,${btoa(bin)}`;
          if (alive) setImages((m) => new Map(m).set((a.contentId as string).toLowerCase(), uri));
        } catch {
          /* the placeholder stays; the image is still downloadable from the attachment list */
        }
      })();
    }
    return () => {
      alive = false;
    };
  }, [message]);
  return images;
}

/** Sanitise a message's HTML for display; `cid:` images resolve to the data: URIs loaded above. */
export function useSanitizedMailHtml(
  message: MailMessage,
  loadRemote: boolean,
  inline: Map<string, string>
): SanitizedMail | null {
  return useMemo(() => {
    if (!message.html) return null;
    return sanitizeMailHtml(message.html, {
      loadRemote,
      resolveCid: (cid) => inline.get(cid.toLowerCase()) ?? null,
    });
  }, [message, loadRemote, inline]);
}

/**
 * The display frame: sanitised HTML in a sandboxed `srcdoc` iframe. No scripts, forms,
 * same-origin access or top navigation; see sanitize.ts for the layers behind this.
 */
export function MailHtmlBody({
  title,
  body,
  loadRemote,
}: {
  title: string;
  body: string;
  loadRemote: boolean;
}) {
  const srcDoc = useMemo(() => buildMailSrcDoc(body, loadRemote, window.location.origin), [body, loadRemote]);
  return (
    <iframe
      className="mail-html"
      data-ui="mail-html-frame"
      title={title}
      sandbox={MAIL_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
    />
  );
}
