const FULL_ACCESS_MODES = new Set([
  "full-access",
  "full access",
  "full_access",
  "danger-full-access",
  "dangerfullaccess"
]);

export function normalizeCodexPermissions(value = null) {
  if (value == null) return null;
  const source = typeof value === "string" ? { mode: value } : value;
  if (!source || typeof source !== "object") return null;

  const mode = normalizeMode(source.mode);
  if (mode === "full-access") return { mode };

  const normalized = {
    ...(mode ? { mode } : {}),
    ...(source.approvalPolicy ? { approvalPolicy: source.approvalPolicy } : {}),
    ...(source.approvalsReviewer ? { approvalsReviewer: source.approvalsReviewer } : {}),
    ...(source.sandboxPolicy ? { sandboxPolicy: source.sandboxPolicy } : {})
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function sameCodexPermissions(left, right) {
  return JSON.stringify(normalizeCodexPermissions(left)) === JSON.stringify(normalizeCodexPermissions(right));
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!mode) return null;
  if (FULL_ACCESS_MODES.has(mode)) return "full-access";
  return mode;
}
