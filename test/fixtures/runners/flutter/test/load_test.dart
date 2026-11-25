import 'package:flutter_test/flutter_test.dart';

void main() {
  test('never runs', () {
    final int n = 'not a number';
    expect(n, 1);
  });
}
