function foo(x) {
	return {
		get x() {
			return x;
		}
	}
}
var bad = foo;
