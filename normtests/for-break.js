var foo = ['foo','bar',null,'baz'];
var x = '';
for (var i=0; i<foo.length; i++) {
	if (!foo[i])
		break;
	x += foo[i];
}
console.log(x);
