export function unsupportedSalesIdentifier(kind, identifier, allowedValues) {
  const code = 'UNSUPPORTED_SALES_' + kind;
  const allowed = [...allowedValues];
  return Object.assign(new Error(code + ': ' + identifier + '; allowed: ' + allowed.join(', ')), {
    code,
    details: { invalid_identifier: identifier, allowed_values: allowed },
  });
}
