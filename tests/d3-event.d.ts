
interface Behavior{
    /**
    * Constructs a new drag behaviour
    */
    drag(): Drag;
}

interface Drag {
    on(): number;
}

declare var d3 : {
    behavior : {
        drag(): Drag;
    }
}
