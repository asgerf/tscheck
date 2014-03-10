function Foo() {
}
Foo.prototype.x = 5;

function good() {
	return new Foo();
}
function bad() {
	return new Foo();
}