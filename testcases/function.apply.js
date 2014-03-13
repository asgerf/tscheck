var obj = {
	x: 'sdf',
	foo: function() {
		return this.bar.apply(this, arguments)
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
