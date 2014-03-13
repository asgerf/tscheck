var obj = {
	x: 'foo',
	foo: function(x) {
		return this.bar.call(this, x)
	},
	bar: function(x) {
		return {first: x.f, second: this.x}
	}
}

function good() {
	return obj.foo({f: 5})
}
function bad() {
	return obj.foo({f: false})
}
