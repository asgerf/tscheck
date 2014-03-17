function good(x, fn) {
	return fn.apply(undefined, x)
}
var bad = good;
