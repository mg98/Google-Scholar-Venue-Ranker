(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRAuthorship = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function normalizeAuthorCount(authorCount) {
    const count = Number(authorCount);
    if (!Number.isFinite(count) || count <= 0) {
      return null;
    }
    return Math.round(count);
  }

  function getFractionalCredit(authorCount) {
    const count = normalizeAuthorCount(authorCount);
    return count == null ? null : 1 / count;
  }

  function getAuthorshipFactor(authorCount) {
    return getFractionalCredit(authorCount) || 0;
  }

  return {
    normalizeAuthorCount,
    getFractionalCredit,
    getAuthorshipFactor,
  };
});
