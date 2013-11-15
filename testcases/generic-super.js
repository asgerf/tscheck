function A(x) {
	this.x = x;
}
function B(x,y) {
	A.call(this,x);
	this.y = y;
}
var good = new B("foo",5);
var bad = new B(42,6);
