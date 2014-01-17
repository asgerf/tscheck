var foo = ['foo','bar',null,'baz'];
var x = '';
Q: L: for (var i=0; i<foo.length; i++) {
	if (!foo[i])
		continue L;
	if (!foo[i])
		continue Q;
	x += foo[i];
}
console.log(x);
