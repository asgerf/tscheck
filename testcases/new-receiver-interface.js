var obj = {
	x: 0,
	foo: function() {
		var self = this
		return function() {
			this.x = self.x
			this.foo = self.foo
		}
	}
}

var good = obj;
var bad = obj;
