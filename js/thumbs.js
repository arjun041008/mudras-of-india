(function () {
    function fillThumbs() {
      document.querySelectorAll(".mudra-card").forEach(function (card) {
        var thumb = card.querySelector(".thumb");
        if (!thumb || thumb.dataset.rig) return;
        var m = App.byId.get(card.dataset.id);
        if (!m) return;
        thumb.dataset.rig = "1";
        thumb.classList.remove("is-missing");
        thumb.innerHTML = '<svg class="stage-hands thumb-rig" viewBox="0 0 600 440" aria-hidden="true"><g class="rig">' +
          Stage.poseMarkup(m) + "</g></svg>";
      });
    }
    var render = App.render;
    App.render = function (list) { render(list); fillThumbs(); };
    fillThumbs();
  })();
