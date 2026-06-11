/*
 * text_normalize.js
 * Shared Unicode text folding used by every matcher in GSVR.
 *
 * Scholar, DBLP, CORE, and SCImago frequently disagree on the rendering of the
 * same name or title ("Muller" with or without umlaut, "Sao" vs accented form,
 * curly vs straight quotes). Exact-match and token-overlap matching must
 * therefore compare diacritic-folded text on BOTH sides, or borderline-correct
 * matches silently fall below similarity thresholds.
 *
 * All character data below is expressed as \u escapes so the file survives any
 * editor/encoding round-trip.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRTextNormalize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Letters that do NOT decompose under NFKD but commonly vary between sources.
  const SPECIAL_FOLD = Object.freeze({
    'ß': 'ss', 'ẞ': 'SS', // sharp s
    'æ': 'ae', 'Æ': 'AE', // ae ligature
    'œ': 'oe', 'Œ': 'OE', // oe ligature
    'ø': 'o', 'Ø': 'O',   // slashed o
    'đ': 'd', 'Đ': 'D',   // d with stroke
    'ð': 'd', 'Ð': 'D',   // eth
    'þ': 'th', 'Þ': 'TH', // thorn
    'ł': 'l', 'Ł': 'L',   // l with stroke
    'ħ': 'h', 'Ħ': 'H',   // h with stroke
    'ı': 'i',                  // dotless i
    'ŋ': 'n', 'Ŋ': 'N',   // eng
  });
  const SPECIAL_FOLD_RX = new RegExp(`[${Object.keys(SPECIAL_FOLD).join('')}]`, 'g');

  // Combining marks produced by NFKD decomposition (plus the rarer mark blocks).
  const COMBINING_MARKS_RX = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

  function foldDiacritics(value) {
    const text = String(value ?? '');
    if (!text) return '';
    let decomposed;
    try {
      decomposed = text.normalize('NFKD');
    } catch (_) {
      decomposed = text;
    }
    return decomposed
      .replace(COMBINING_MARKS_RX, '')
      .replace(SPECIAL_FOLD_RX, (ch) => SPECIAL_FOLD[ch] || ch);
  }

  return {
    foldDiacritics,
  };
});
