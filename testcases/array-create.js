function good(x, y, z) {
	var w = []
	w[0] = x;
	w[1] = y;
	w[2] = z;
	return w;
}
function good_push(x, y, z) {
	var w = []
	w.push(x)
	w.push(y)
	w.push(z)
	return w;
}
var bad = good;
var bad_push = good_push;
