'use strict';

// 1. Карта идеального склонения названий сказок (Про кого? Про что?)
const titleAccusativeMap = {
    'Колобок': 'Колобка',
    'Репка': 'Репку',
    'Красная Шапочка': 'Красную Шапочку',
    'Кот в сапогах': 'Кота в сапогах',
    'Три медведя': 'Трёх медведей',
    'Теремок': 'Теремок',
    'Гуси-лебеди': 'Гусей-лебедей',
    'Золушка': 'Золушку',
    'Дюймовочка': 'Дюймовочку'
};

// 2. Короткие, живые вступления без ИИ-воды
const PHRASES = {
    // Вступления перед сказками (уже со склонением)
    story_intro_1: "Слушай. Сказка про ",
    story_intro_2: "О, давай. Сказка про ",
    story_intro_3: "Так... Сказка про ",
    story_intro_4: "Отличный выбор! Сказка про ",

    // Быстрые маркеры для других режимов
    empty_text: ["А? Повтори-ка.", "Не расслышала, еще раз?", "Хм? Что ты сказал?", "Прошуршало что-то. Повтори?"],
    rejected_story: ["Ладно, отложим книжку.", "Хорошо, почитаем потом.", "Окей, без сказок."],
    rejected_riddle: ["Ладно, загадки отменяются.", "Нет так нет.", "Окей, проехали загадки."],
    rejected_default: ["Хорошо, не будем.", "Ладно, отменим.", "Договорились."]
};

// Функция, которая берет правильный падеж для сказки
function getSlantedTitle(title) {
    return titleAccusativeMap[title] || title;
}

// Функция, которая выбирает случайную фразу из списка
function pick(key) {
    const list = PHRASES[key];
    if (!list) return '';
    return list[Math.floor(Math.random() * list.length)];
}

// Функция, которая собирает объявление сказки с правильным падежом
function getRandomStoryIntro(title) {
    const slanted = getSlantedTitle(title);
    const intros = [
        `${PHRASES.story_intro_1}${slanted}. `,
        `${PHRASES.story_intro_2}${slanted}. `,
        `${PHRASES.story_intro_3}${slanted}. `,
        `${PHRASES.story_intro_4}${slanted}. `
    ];
    return intros[Math.floor(Math.random() * intros.length)];
}

module.exports = { pick, getRandomStoryIntro };
