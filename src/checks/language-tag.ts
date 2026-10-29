/** Syntax of a BCP 47 language tag; there is no registry lookup, so unknown codes pass. */
const BCP47 =
  /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z0-9]{5,8}|\d[a-z0-9]{3}))*(?:-[a-wyz0-9](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$|^x(?:-[a-z0-9]{1,8})+$/i;

export function isLanguageTag(tag: string): boolean {
  return BCP47.test(tag);
}
