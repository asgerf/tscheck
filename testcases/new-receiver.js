function Foo(x) {
	this.x = x;
}
Foo.prototype.bar = function() {
	return new Foo(this.x+1)
}

function good() {
	return new Foo(4);
}
function bad() {
	return new Foo("str");
}