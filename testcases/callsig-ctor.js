function Foo(x) {
	this.x = x;
	this.y = "df";
}
Foo.prototype.getX = function() {
	return this.x;
}
Foo.prototype.getY = function() {
	return this.y;
}
