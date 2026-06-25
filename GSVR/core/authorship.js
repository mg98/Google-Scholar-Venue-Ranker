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

  const AUTHORSHIP_SOURCE = "dblp-author-order";
  const AUTHORSHIP_STATUS = Object.freeze({
    VERIFIED: "verified",
    UNKNOWN: "unknown",
  });
  const AUTHORSHIP_ROLES = Object.freeze({
    FIRST: "first",
    LAST: "last",
  });

  function normalizeDblpPid(value) {
    return String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.html$/i, "");
  }

  function normalizeDblpAuthor(author, index = 0, totalCount = null) {
    const source = author && typeof author === "object" ? author : {};
    const zeroBasedIndex = Number.isFinite(Number(source.index))
      ? Math.max(0, Math.round(Number(source.index)))
      : Math.max(0, Math.round(Number(index) || 0));
    const normalizedTotal = normalizeAuthorCount(totalCount ?? source.authorCount);
    return {
      name: String(source.name ?? source.textContent ?? "").replace(/\s+/g, " ").trim() || null,
      pid: normalizeDblpPid(source.pid ?? source.getAttribute?.("pid") ?? ""),
      index: zeroBasedIndex,
      position: zeroBasedIndex + 1,
      authorCount: normalizedTotal,
    };
  }

  function normalizeDblpAuthors(authors) {
    const list = Array.isArray(authors) ? authors : [];
    const total = list.length;
    return list
      .map((author, index) => normalizeDblpAuthor(author, index, total))
      .map((author) => ({ ...author, authorCount: total || author.authorCount || null }));
  }

  function extractOrderedAuthorsFromDblpElement(element) {
    if (!element?.querySelectorAll) {
      return [];
    }
    return normalizeDblpAuthors(Array.from(element.querySelectorAll("author")).map((node, index) => ({
      name: node.textContent || "",
      pid: node.getAttribute?.("pid") || "",
      index,
    })));
  }

  function createUnknownAuthorship(profilePid = null, authorCount = null, reason = "unknown") {
    return {
      status: AUTHORSHIP_STATUS.UNKNOWN,
      roles: [],
      position: null,
      authorCount: normalizeAuthorCount(authorCount),
      profilePid: normalizeDblpPid(profilePid) || null,
      source: AUTHORSHIP_SOURCE,
      reason,
    };
  }

  function classifyAuthorPosition({ profilePid, authors, authorCount } = {}) {
    const normalizedProfilePid = normalizeDblpPid(profilePid);
    const normalizedAuthors = normalizeDblpAuthors(authors);
    const count = normalizeAuthorCount(authorCount ?? normalizedAuthors.length);
    if (!normalizedProfilePid || normalizedAuthors.length === 0) {
      return createUnknownAuthorship(normalizedProfilePid, count, normalizedProfilePid ? "empty_author_list" : "missing_profile_pid");
    }

    const matches = normalizedAuthors.filter((author) => normalizeDblpPid(author.pid) === normalizedProfilePid);
    if (matches.length !== 1) {
      return createUnknownAuthorship(
        normalizedProfilePid,
        count,
        matches.length > 1 ? "duplicate_profile_pid" : "profile_pid_not_found"
      );
    }

    const match = matches[0];
    const position = normalizeAuthorCount(match.position);
    const resolvedCount = normalizeAuthorCount(count ?? match.authorCount ?? normalizedAuthors.length);
    if (!position || !resolvedCount || position > resolvedCount) {
      return createUnknownAuthorship(normalizedProfilePid, resolvedCount, "invalid_author_position");
    }

    const roles = [];
    if (resolvedCount > 1) {
      if (position === 1) {
        roles.push(AUTHORSHIP_ROLES.FIRST);
      }
      if (position === resolvedCount) {
        roles.push(AUTHORSHIP_ROLES.LAST);
      }
    }

    return {
      status: AUTHORSHIP_STATUS.VERIFIED,
      roles,
      position,
      authorCount: resolvedCount,
      profilePid: normalizedProfilePid,
      source: AUTHORSHIP_SOURCE,
      reason: roles.length ? null : (resolvedCount === 1 ? "single_author" : "middle_author"),
    };
  }

  function normalizeAuthorship(value) {
    const input = value && typeof value === "object" ? value : {};
    const status = input.status === AUTHORSHIP_STATUS.VERIFIED
      ? AUTHORSHIP_STATUS.VERIFIED
      : AUTHORSHIP_STATUS.UNKNOWN;
    const roleSet = new Set(
      (Array.isArray(input.roles) ? input.roles : [])
        .map((role) => String(role || "").trim().toLowerCase())
        .filter((role) => role === AUTHORSHIP_ROLES.FIRST || role === AUTHORSHIP_ROLES.LAST)
    );
    const authorCount = normalizeAuthorCount(input.authorCount);
    const roles = status === AUTHORSHIP_STATUS.VERIFIED && authorCount !== 1 ? Array.from(roleSet) : [];
    return {
      status,
      roles,
      position: normalizeAuthorCount(input.position),
      authorCount,
      profilePid: normalizeDblpPid(input.profilePid) || null,
      source: AUTHORSHIP_SOURCE,
      reason: input.reason ? String(input.reason) : (status === AUTHORSHIP_STATUS.VERIFIED && authorCount === 1 ? "single_author" : null),
    };
  }

  return {
    AUTHORSHIP_SOURCE,
    AUTHORSHIP_STATUS,
    AUTHORSHIP_ROLES,
    normalizeAuthorCount,
    getFractionalCredit,
    getAuthorshipFactor,
    normalizeDblpPid,
    normalizeDblpAuthor,
    normalizeDblpAuthors,
    extractOrderedAuthorsFromDblpElement,
    createUnknownAuthorship,
    classifyAuthorPosition,
    normalizeAuthorship,
  };
});
