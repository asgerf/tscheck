function good(x, fn) {
	return fn(5, x);
}
var bad = good;
var bad2 = good;
