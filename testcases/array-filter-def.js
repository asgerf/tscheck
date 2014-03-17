function filter(xs, callback) {
	var i = 0,
		length = xs.length,
		ret = [];
	for ( ; i < length; ++i ) {
		if (callback(xs[i], i)) {
			ret.push(xs[i])
		}
	}
	return ret
}
var bad = filter;
