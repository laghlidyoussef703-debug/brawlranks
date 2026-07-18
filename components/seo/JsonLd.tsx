import { serializeJsonLd } from "@/lib/seo/jsonld";

/**
 * Generic server-rendered JSON-LD emitter (PHASE6.md Section 9's
 * `components/seo/` JsonLd entry). Renders build-time/render-time typed
 * data only — never user input — through serializeJsonLd's safe escaping,
 * so the dangerouslySetInnerHTML usage here is the standard, safe Next.js
 * JSON-LD pattern, not an XSS surface.
 */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      // Safe: serializeJsonLd escapes script-breaking sequences, and the
      // input is always server-built typed data, never user input.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
