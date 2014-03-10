function f() {
	return function() {
		return 5;
	}
}
var good = f;
var bad = f;
