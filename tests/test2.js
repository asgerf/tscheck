var A;
(function (A) {
    function h() {
        return "foo";
    }
    A.h = h;
    A.x = 5;

    var Foo = (function () {
        function Foo(x) {
            this.x = x;
        }
        return Foo;
    })();
    A.Foo = Foo;

    function g() {
        return { y: 5 };
    }
    A.g = g;
})(A || (A = {}));
