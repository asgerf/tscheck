var obj = {
	foo: function() {
		function bar(x, y) {
			return this.baz(x, y)
		}
		return bar.apply(this, arguments)
	},
	baz: function(x, y) {
		return {x: x, y: y}
	}
}

function good() {
	return obj.foo('abc', 2);
}
function bad() {
	return obj.foo('abc', 'def');
}