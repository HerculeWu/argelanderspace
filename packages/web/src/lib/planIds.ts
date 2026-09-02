// `p_<8 hex>` / `t_<8 hex>` id generation (Stage 4). The web runtime must not
// import @argelanderspace/core (it is a devDependency for tests only), so this
// mirrors core's newPlanId/newTaskId (crypto.randomBytes(4).toString("hex"))
// with the WebCrypto equivalent — same shape the contracts schema enforces.

function hex8(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newPlanId(): string {
  return `p_${hex8()}`;
}

export function newTaskId(): string {
  return `t_${hex8()}`;
}
