function reassign(dst, src) {
	var k;
	for (var i=2; i<arguments.length; ++i) {
		dst[k = arguments[i]] = src[k]
	}
}

var Baz = {
	foo: 5,
	baz: "str"
}

function foo() {
	var obj = {}
	reassign(obj, Baz, 'foo')
	return obj
}
var bad = foo;