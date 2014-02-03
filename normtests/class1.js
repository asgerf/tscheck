function Foo(x) {
	this.x = x;
}
Foo.prototype.increment = function() {
	this.x++;
}

var f = new Foo(3);
f.increment();
f.increment();
console.log(f.x);
