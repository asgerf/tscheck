function A() {
	this.x = 5;
}
function B() {
	A.call(this);
	this.y = 6;
}
var b = new B();

var bad = {y: 6}
