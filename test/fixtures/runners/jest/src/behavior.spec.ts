test('assertion fails', () => {
  expect(1 + 1).toBe(3);
});

test('throws at runtime', () => {
  const obj: { boom?: () => void } = {};
  obj.boom!();
});
