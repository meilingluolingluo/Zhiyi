/** Remove unpaired surrogates rejected by providers; preserve valid Unicode pairs. */
export function sanitizeSurrogates(text: string): string {
  const wellFormed = (text as string & { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof wellFormed === "function" && wellFormed.call(text)) {
    return text;
  }
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}
