var foo = {
	get f() {
		return this.g;
	},
	g: 5
}


function good() {
	return foo.f;
}
var bad = good;


