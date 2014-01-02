function Foo(x) {
	this.x = x;
}
var good = new Foo(45);
var bad = {
	x: 45
};

