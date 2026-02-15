/**
 * Creates a URL-friendly slug from text.
 * @param {string} text - The text to slugify
 * @param {Object} publishedPages - Optional object of existing slugs to check for uniqueness
 * @returns {string} A unique slug
 */
module.exports = function slugify(text, publishedPages = {}) {
  if (!text || typeof text !== "string") {
    return "";
  }

  let baseSlug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

  // If no published pages provided, just return the base slug
  if (!publishedPages || Object.keys(publishedPages).length === 0) {
    return baseSlug;
  }

  // Check for collision and append counter if needed
  let slug = baseSlug;
  let counter = 1;
  while (publishedPages[slug]) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
};
