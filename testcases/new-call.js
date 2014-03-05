function Foo(x) {
	this.x = x;
}
Foo.prototype.bar = function() {
	return this.x;
}

function good(x) {
	return new Foo(x).bar();
}
var bad = good;
