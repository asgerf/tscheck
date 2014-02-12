function make(x) {
	return function(y) {
		return {x: x, y: y};
	}
}
var good = make("foo")
var bad = make(4)
