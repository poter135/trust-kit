import 'package:flutter_test/flutter_test.dart';

void main() {
  test('assertion fails', () {
    expect(1 + 1, 3);
  });

  test('throws at runtime', () {
    throw StateError('boom');
  });
}
