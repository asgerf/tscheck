function f(x) {
	return function() {
		return x;
	}
}
var z = f(5);
console.log(z());
