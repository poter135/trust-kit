test('registered before the suite-level error', () => {
  expect(1 + 1).toBe(2);
});

afterAll(() => {
  throw new Error('suite-level boom after tests');
});
