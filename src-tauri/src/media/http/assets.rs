use crate::resource_server::{self, Response};

pub(super) fn response(path: &str) -> Response {
    let (mime, body) = match path {
        "player" => ("text/html; charset=utf-8", include_str!("../../../resources/media-preview/index.html")),
        "player.js" => ("text/javascript; charset=utf-8", include_str!("../../../resources/media-preview/player.js")),
        "player.css" => ("text/css; charset=utf-8", include_str!("../../../resources/media-preview/player.css")),
        _ => ("text/plain; charset=utf-8", "not found"),
    };
    resource_server::full(200, mime, body)
}
